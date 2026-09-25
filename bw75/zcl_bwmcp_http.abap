CLASS zcl_bwmcp_http DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
    INTERFACES if_http_extension .

*   Bumped whenever the payload gains or loses a field. The client reads the
*   capability list, not this number, but the number makes a mismatch reportable.
    CONSTANTS c_version TYPE string VALUE '1.1.0' .
  PROTECTED SECTION.
  PRIVATE SECTION.
    METHODS send
      IMPORTING
        !io_server TYPE REF TO if_http_server
        !i_status  TYPE i
        !i_body    TYPE string .
ENDCLASS.



CLASS zcl_bwmcp_http IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    DATA l_method TYPE string.
    DATA l_dtp    TYPE rsbkdtpnm.
    DATA l_raw    TYPE string.
    DATA l_json   TYPE string.
    DATA l_s_res  TYPE zcl_bwmcp_dtp_filter=>t_s_result.

    l_method = server->request->get_header_field( '~request_method' ).
    IF l_method <> 'GET'.
      send( io_server = server
            i_status  = 405
            i_body    = '{"error":"only GET is supported"}' ).
      RETURN.
    ENDIF.

    l_raw = server->request->get_form_field( 'dtp' ).

*   Without a DTP the endpoint answers with its own identity. A client probes with
*   this call, and the capability list lets it degrade per capability rather than
*   all at once when it meets an older build of this handler.
    IF l_raw IS INITIAL.
      send( io_server = server
            i_status  = 200
            i_body    = |\{"service":"bwmcp","version":"{ c_version }","capabilities":| &&
                        |["dtp_filter","dtp_routine","dtp_semantic_group","dtp_package_size"]\}| ).
      RETURN.
    ENDIF.

    TRANSLATE l_raw TO UPPER CASE.
    l_dtp = l_raw.

    l_s_res = zcl_bwmcp_dtp_filter=>get_filter( l_dtp ).
    l_json  = /ui2/cl_json=>serialize(
                data        = l_s_res
                pretty_name = /ui2/cl_json=>pretty_mode-low_case ).

    IF l_s_res-found = abap_true.
      send( io_server = server i_status = 200 i_body = l_json ).
    ELSE.
      send( io_server = server i_status = 404 i_body = l_json ).
    ENDIF.

  ENDMETHOD.

  METHOD send.

    DATA l_xbody TYPE xstring.

    l_xbody = cl_abap_codepage=>convert_to( source = i_body codepage = 'UTF-8' ).

    io_server->response->set_status( code = i_status reason = '' ).
    io_server->response->set_header_field(
      name  = 'content-type'
      value = 'application/json; charset=utf-8' ).
    io_server->response->set_data( l_xbody ).

  ENDMETHOD.

ENDCLASS.
