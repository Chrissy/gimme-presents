module ApplicationHelper

    def can_edit(list)
      current_user && current_user.id == list.user
    end

    def user_authenticated?
      current_user.try(:authenticated?)
    end

    def button_text_for_user_auth(list)
      if can_edit(list)
        "Save this list with my Google account"
      else
        "Login with Google to edit your list"
      end
    end
end
